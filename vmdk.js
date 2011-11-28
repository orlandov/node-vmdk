var fs = require('fs');
var assert = require('assert');
var ctype = require('ctype');
var compress = require('compress');
var async = require('async');
var util = require('util');

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
  var buffer = new Buffer(512);
  fs.read(this.fd, buffer, 0, 512, offset, function (error, bytesRead, buf) {
    return callback(error, buffer);
  });
}

VMDK.prototype.markerAt = function (offset, callback) {
  var self = this;
  var buffer = new Buffer(512);

  self.dataAt(offset, 512, function (error, buffer) {
    var marker = self.parser.readData(MarkerStruct, buffer, 0);
    callback(null, marker);
  });
}

VMDK.prototype.getMarker = function (offset, callback) {
  var self = this;
  var buffer = new Buffer(512);

  self.dataAt(offset, 12, function (error, buffer) {
    var marker = self.parser.readData(MarkerStruct, buffer, 0);
    var type = self.markerType(marker);
    switch (type) {
      case 'grain':
        var grain = self.parser.readData(GrainMarkerStruct, buffer, 0);
        console.warn("Grain:");
        console.dir(grain);
        return callback(null, type, grain);
      default:
        console.warn("Unknown type %s", type);
        console.dir(marker);
        return callback(null, type, marker);
    }
  });
}

var nextClosest = function (x) {
  return 512*Math.ceil(x/512);
}

VMDK.prototype.writeRaw = function (filename, callback) {
  var self = this;
  var gunzip = new compress.Gunzip(true, false);

  var offset = self.header.overHead[0] * 512;
  var done = false;
  var buffer = new Buffer(512);

  async.whilst(
    function () { return !done; },
    function (callback) {
      self.getMarker(offset, function (error, type, marker) {
        console.warn("Marker at " +  offset + " was %s", type);
        var size = marker.size;
        if (marker.size) {
          fs.read(self.fd, buffer, 0, 512, offset, function (error, bytesRead, buf) {
            console.warn("Read %d bytes", bytesRead);
            offset = nextClosest(offset + 12 + marker.size);
            callback();
          });
        }
        else {
          if (type === 'eos') 
            done = true;
          else
            offset = nextClosest(offset + 12 + marker.val[0] * 512);
          callback();
        }
      });
    },
    function () {
      console.warn("all done");
    }
  );
  /*
  self.getMarker(offset, function (error, type, grain) {
    var size = grain.size;
    var buffer = new Buffer(size);
    fs.read(self.fd, buffer, 0, size, null, function (error, bytesRead, buf) {
      console.log("Read %d bytes", bytesRead);

      offset = offset + 12 + size;
      offset = nextClosest(offset);

      self.getMarker(offset, function (error, type, marker) {
        console.dir(arguments);
        console.log("Marker was %d bytes", marker.size);
        console.dir(marker);
        var size = grain.size;
        var buffer = new Buffer(size);
        fs.read(self.fd, buffer, 0, size, null, function (error, bytesRead, buf) {
          console.log("Read %d bytes", bytesRead);
        });
      });
      //return callback(error, buffer);
    });
*/

    /*
    // Pump data to be compressed
    gunzip.write(grain.data, function (error, d0) {
      console.log(error);
      gunzip.close(function (error, d1) {
        console.log(error);
        console.log("Decompressed:");
        console.dir(d0.toString('ascii'));
      });
    });
    */
}

var VMDKStream = function (vmdk) {
  this.vmdk = vmdk;
}

util.inherits(VMDKStream, process.EventEmitter);

VMDK.prototype.stream = function () {
  return new VMDKStream(this);
}

VMDKStream.prototype.start = function () {
  var self = this;

  var readSize = 2048;
  var offset = self.vmdk.header.overHead[0] * 512;
  var done = false;
  var buffer = new Buffer(readSize);

  async.whilst(
    function () { return !done; },
    function (callback) {
      self.vmdk.getMarker(offset, function (error, type, marker) {
        console.warn("Marker at " +  offset + " was %s", type);

        var size = marker.size;

        if (type === 'grain' && marker.size) {

          // Find out the size of this grain marker
          fs.read(self.vmdk.fd, buffer, 0, 512, offset, function (error, bytesRead, buf) {
            var toRead = marker.size > readSize ?  readSize : marker.size;

            // Read and emit the grain data
            fs.read(self.vmdk.fd, buffer, 0, toRead, offset, function (error, bytesRead, buf) {
              console.warn("Read %d bytes", bytesRead);
            });

            console.warn("Read %d bytes", bytesRead);
            offset = nextClosest(offset + 12 + marker.size);
            self.emit('data', 'Got ' + marker.size + ' bytes');
            callback();
          });
        }
        else {
          if (type === 'eos') {
            done = true;
          }
          else {
            offset = nextClosest(offset + 12 + marker.val[0] * 512);
          }
          callback();
        }
      });
    },
    function () {
      self.emit('end');
    }
  );
}
