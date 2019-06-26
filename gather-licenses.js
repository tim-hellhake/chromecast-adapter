#!/usr/bin/env node

const nlf = require('nlf');
const fs = require('fs');
const {promisify} = require('util');
const packageInfo = require('./package.json');

Promise.all([
  promisify(fs.readFile)('./LICENSE'),
  promisify(nlf.find)({
    directory: __dirname,
    production: true,
  }),
]).then(([ baseLicense, info ]) => {
  const licenses = ([
    baseLicense,
  ].concat(info.filter((pkg) => pkg.name != packageInfo.name).map((pkg) => {
    if (pkg.licenseSources.license &&
        pkg.licenseSources.license.sources.length) {
      return `License for ${pkg.name}:
${pkg.licenseSources.license.sources.map((s) => s.text).join('\n\n')}`;
    }

    // eslint-disable-next-line max-len
    return `License for ${pkg.name}: ${pkg.licenseSources.package.sources.map((s) => s.license).join(', ')}`;
  }))).join('\n\n');
  return promisify(fs.writeFile)('./package/LICENSE', licenses);
});
