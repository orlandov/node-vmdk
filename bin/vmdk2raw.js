#!/usr/bin/env node
var async = require('async');
var sys = require('sys');
var VMDK = require('../lib/vmdk');

if (!process.argv[2]) {
  console.error("Must pass in vmdk file as argument");  
  process.exit(1);
}

var filename = process.argv[2];
var v = new VMDK({ filename: filename });

v.open(function (error) {
  var stream = v.stream();

  v.footer(function (error, footer) {
    console.warn("Footer:");
    console.warn(sys.inspect(footer));

    v.directory(function () {
      process.exit(0);
    });

    stream.pipe(process.stdout);
    stream.on('end', function () {
      console.warn("This is done");
      v.close();
    });

    stream.start();
  });
});
