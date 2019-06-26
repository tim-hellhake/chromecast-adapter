#!/usr/bin/env bash

rm -rf *.tgz package/
TARFILE=$(npm pack)
tar xzf ${TARFILE}
npm ci
npm run licenses
cd package
sha256sum LICENSE > SHA256SUMS
cd ..
sha256sum package.json adapter.js > package/SHA256SUMS
rm -rf node_modules
npm ci --production
find node_modules -type f -exec sha256sum {} \; >> package/SHA256SUMS
cp -r node_modules ./package
tar czf ${TARFILE} package
rm -rf package
sha256sum ${TARFILE}
echo "Created ${TARFILE}"
