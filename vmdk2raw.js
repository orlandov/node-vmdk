var async = require('async');
var VMDK = require('./vmdk');

var filename = process.argv.length > 1 ? process.argv[2] : './fdbase.vmdk';
var v = new VMDK({ filename: filename });

v.open(function (error) {
  var stream = v.stream();

  stream.pipe(process.stdout, function () {
    v.close();
  });

  stream.on('data', function () {
    console.log("Got data");
    
  });
  stream.start();
});
