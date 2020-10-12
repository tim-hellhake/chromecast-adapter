#!/bin/bash -e

TARFILE=`npm pack`

tar xzf ${TARFILE}
npm install
npm run licenses
cd package
shasum --algorithm 256 manifest.json package.json adapter.js LICENSE README.md > SHA256SUMS
cd ..
rm -rf node_modules
npm install --production
find node_modules \( -type f -o -type l \) -exec shasum --algorithm 256 {} \; >> package/SHA256SUMS
cp -r node_modules ./package
tar czf ${TARFILE} package

shasum --algorithm 256 ${TARFILE} > ${TARFILE}.sha256sum

rm -rf SHA256SUMS package
