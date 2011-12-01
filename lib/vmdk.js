var fs = require('fs');
var assert = require('assert');
var ctype = require('ctype');
var compress = require('compress');
var async = require('async');
var util = require('util');
var Stream = require('stream').Stream;

var SECTOR_SIZE = 512;

var VMDK = function (options) {
  this.options = options;
  assert.ok(options.filename);
  this.parser = new ctype.Parser({ endian: 'little' });
}

module.exports = VMDK;

/*

  typedef struct vmdk_header {
     uint32_t   magicNumber;
     uint32_t   version;
     uint32_t   flags;
     SectorType disk_sectors;
     SectorType grainSize;
     SectorType descriptorOffset;
     SectorType descriptorSize;
     uint32_t   numGTEsPerGT;
     SectorType rgdOffset;
     SectorType gdOffset;
     SectorType overHead;
     Bool       uncleanShutdown;
     char       singleEndLineChar;
     char       nonEndLineChar;
     char       doubleEndLine[2];
     uint16_t   compressAlgo;
     uint8_t    pad[433];
  } __attribute__((__packed__)) vmdk_header_t;

*/

var SparseExtentHeaderStruct
  = [ { magicNumber:       { type: 'char[4]' } }
    , { version:           { type: 'uint32_t' } }
    , { flags:             { type: 'uint32_t' } }
    , { capacity:          { type: 'SectorType' } }
    , { grainSize:         { type: 'SectorType' } }
    , { descriptorOffset:  { type: 'SectorType' } }
    , { descriptorSize:    { type: 'SectorType' } }
    , { numGTEsPerGT:      { type: 'uint32_t' } }
    , { rgdOffset:         { type: 'SectorType' } }
    , { gdOffset:          { type: 'SectorType' } }
    , { overHead:          { type: 'SectorType' } }
    , { uncleanShutdown:   { type: 'uint8_t' } }
    , { singleEndLineChar: { type: 'char' } }
    , { nonEndLineChar:    { type: 'char' } }
    , { doubleEndLine:     { type: 'char[2]' } }
    , { compressAlgo:      { type: 'uint16_t' } }
    , { pad:               { type: 'uint8_t[433]' } }
    ];

var MarkerStruct
  = [ { val:  { type: 'SectorType' } }
    , { size: { type: 'uint32_t' } }
    , { type: { type: 'uint32_t' } }
    ];

var GrainMarkerStruct
  = [ { val:  { type: 'SectorType' } }
    , { size: { type: 'uint32_t' } }
    ];

VMDK.prototype.open = function (callback) {
  fs.close(this.fd, callback);
}

VMDK.prototype.open = function (callback) {
  var self = this;
  fs.open(this.options.filename, 'r', function (error, fd) {
    if (error) {
      return callback(error);
    }
    self.fd = fd;
    self.parseHeader(callback);
  });
}

VMDK.prototype.parseHeader = function (callback) {
  var self = this;

  var buffer = new Buffer(512);
  fs.read(this.fd, buffer, 0, 512, 0, function (error, bytesRead, buf) {
    if (error) {
       return callback(error);
    }
    self.header = self.parseSparseExtentHeader(buffer);

    assert.equal(self.header.magicNumber.toString(), 'KDMV');

    return callback();
  });
}

var MARKER_EOS = 0;
var MARKER_GT = 1;
var MARKER_GD = 2;
var MARKER_FOOTER = 3;

VMDK.prototype.markerType = function (marker) {
  if (marker.size) {
    return "grain"
  }
  else switch (marker.type) {
    case MARKER_EOS: return 'eos';
    case MARKER_GD: return 'gd';
    case MARKER_GT: return 'gt';
    case MARKER_FOOTER: return 'footer';
    default: return 'unknown';
  }
}

VMDK.prototype.parseSparseExtentHeader = function (buffer) {
  this.parser.typedef('SectorType', 'uint32_t[2]');
  var header = this.parser.readData(SparseExtentHeaderStruct, buffer, 0);
  delete header.pad;
  return header;
}

VMDK.prototype.dataAt = function (offset, size, callback) {
  var buffer = new Buffer(size);
  fs.read(this.fd, buffer, 0, 512, offset, function (error, bytesRead, buf) {
    return callback(error, buffer);
  });
}

VMDK.prototype.markerAt = function (offset, callback) {
  var self = this;
  var buffer = new Buffer(512);

  self.dataAt(offset, 12, function (error, buffer) {
    var marker = self.parser.readData(MarkerStruct, buffer, 0);
    callback(null, marker);
  });
}

VMDK.prototype.getMarker = function (offset, callback) {
  var self = this;
  var buffer = new Buffer(512);

  self.dataAt(offset, 512, function (error, buffer) {
    var marker = self.parser.readData(MarkerStruct, buffer, 0);
    var type = self.markerType(marker);
    switch (type) {
      case 'grain':
        var grain = self.parser.readData(GrainMarkerStruct, buffer, 0);
        // console.warn("Grain:");
        // console.dir(grain);
        return callback(null, type, grain);
      default:
        // console.warn("Unknown type %s", type);
        // console.dir(marker);
        return callback(null, type, marker);
    }
  });
}

var nextClosest = function (x) {
  return 512*Math.ceil(x/512);
}

var VMDKStream = function (vmdk) {
  this.vmdk = vmdk;
  Stream.call(this);
}

util.inherits(VMDKStream, Stream);

VMDK.prototype.stream = function () {
  return new VMDKStream(this);
}

var DEFAULT_READ_SIZE = 2048;

VMDKStream.prototype.start = function () {
  var self = this;

  var offset = self.vmdk.header.overHead[0] * 512;
  var startOffset = offset;
  var startTime = new Date();
  var done = false;
  var buffer = new Buffer(DEFAULT_READ_SIZE);

  /*
     In a nutshell... *deep breath*

     The extents within VMDK-formatted files are composed of chunks of data
     called "Markers".
     Markers are generic structs of data which which can be casted to more
     specific types based on criteria defined in the VMDK specs.  v4 Sparse
     streamOptimized VMDK files appear to consist of grain, footer and eos
     markers. 
     
     The grain markers are lined up sequentially in the file, such that the
     data in each grain is in the correct order of the disk it's holding.

     The way this will work is that we will iterate over the grain markers and
     their associated compressed data block.

     For each grain's compressed data block, we will read the number of bytes
     set in the marker's "size" field. Each time we do this, we will decompress
     the data and then emit it as a 'data' event.

     Each marker in the file is aligned to a sector, where each sector is 512 bytes.

     For now we only support grain and eos markers.

     Because Node doesn't let us seek on a file descriptor directly, we'll keep
     a running offset within the file.
   */

  async.whilst
  ( function () { return !done; }
  , function (callback) {
      self.vmdk.getMarker(offset, function (error, type, marker) {
        var gunzip = new compress.Gunzip(true, false);
        // console.warn("Marker at " +  offset + " was %s", type);

        var size = marker.size;
        // console.warn("Marker size is " + marker.size);

        offset += 12;
        if (type === 'grain' && marker.size) {
          fs.read
          ( self.vmdk.fd, buffer, 0, 512, offset
          , function (error, bytesRead, buf) {
              // Move past the marker/header.

              var toRead = marker.size;

              // Read and emit data from the compressed grain block until we have
              // read `marker.size` number of bytes.  We'll set how many bytes
              // we wish to read, and then count down from there until 0, at
              // which point we can move on.
              // Move the offset index forward as we read data from the file.
              async.whilst
              ( function () { return toRead > 0; }
              , function (callback) {
                  var readSize = toRead > DEFAULT_READ_SIZE
                                 ? DEFAULT_READ_SIZE : toRead;

                  // console.warn("Toread = %d, readize = %d", toRead, readSize);
                  fs.read
                  ( self.vmdk.fd, buffer, 0, readSize, offset
                  , function (error, bytesRead, buf) {
                      if (error) {
                        return self.emit('error', error);
                      }
                      toRead -= bytesRead;
                      offset += bytesRead;
                      // console.warn("Data chunk toRead= "+toRead);
                      gunzip.write(buf, function (error, decompressed) {
                        if (error) {
                          console.error("gz error " + error.message);
                          // xxx handle gz error
                        }
                        self.emit('data', decompressed);
                        return callback();
                      });
                    }
                  );
                }
              , function (error) {
                  if (error) {
                    return callback(error);
                  }
                  gunzip.close(function (error, decompressed) {
                    if (error) {
                      console.error("gz error " + error.message);
                      return;
                    }
                    if (decompressed)
                      self.emit('data', decompressed);

                    // console.warn("Done grain");

                    // console.warn("MOving to next grain");
                    // console.warn(offset);
                    offset = nextClosest(offset);
                    // console.warn(offset);
                    callback();
                  });
                }
              );
          });
        }
        else if (type === 'eos') {
          done = true;
          callback();
        }
        else {
          callback();
        }
      });
    }
  , function (error) {
      if (error) {
        // console.warn("There was an error: " + error.message);
      }

      var endTime = new Date();
      var delta = (offset - startOffset)/1024;
      var duration = (endTime-startTime)/1000
      console.warn("Parsed %d KiB in %d seconds. (%d KiB/s)",
        delta, duration, Math.floor(delta/duration));
      self.emit('end');
    }
  );
}
