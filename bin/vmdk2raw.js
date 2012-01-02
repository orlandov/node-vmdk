#!/usr/bin/env node
var async = require('async');
var VMDK = require('../lib/vmdk');

if (!process.argv[2]) {
  console.error("Must pass in vmdk file as argument");  
  process.exit(1);
}

var filename = process.argv[2];
var v = new VMDK({ filename: filename });

v.open(function (error) {
  var stream = v.stream();
  stream.pipe(process.stdout);
  stream.on('end', function () {
    console.warn("This is done");
    v.close();
  });
  stream.start();
});
