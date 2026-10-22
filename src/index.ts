#!/usr/bin/env node
import { main } from './cli';

main(process.argv.slice(2))
  .then((code) => {
    // A null code means the daemon is running and should stay alive.
    if (code !== null) process.exit(code);
  })
  .catch(() => {
    // Never break an agent hook because of a CLI failure.
    process.exit(0);
  });
