#!/bin/sh
set -eu

printf 'base_image=%s\n' 'ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517'
printf 'architecture=%s\n' "$(uname -m)"
printf 'node_path=%s\n' "$(command -v node)"
printf 'node_realpath=%s\n' "$(readlink -f /usr/bin/node)"
printf 'node_version=%s\n' "$(/usr/bin/node --version)"
/usr/bin/node <<'NODE'
for (const moduleName of ["webpack", "terser-webpack-plugin", "terser"]) {
  const packagePath = require.resolve(`${moduleName}/package.json`);
  const modulePath = require.resolve(moduleName);
  const version = require(packagePath).version;
  process.stdout.write(`${moduleName}_version=${version}\n`);
  process.stdout.write(`${moduleName}_package=${packagePath}\n`);
  process.stdout.write(`${moduleName}_resolve=${modulePath}\n`);
}
NODE
printf 'python_version=%s\n' "$(python3 --version 2>&1)"
printf 'git_version=%s\n' "$(git --version)"
printf 'os_release_begin\n'
cat /etc/os-release
printf 'os_release_end\n'
printf 'dpkg_inventory_begin\n'
dpkg-query -W -f='${binary:Package}\t${Version}\t${Architecture}\n' | LC_ALL=C sort
printf 'dpkg_inventory_end\n'
