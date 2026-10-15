#!/usr/bin/env node
import { runCli } from "./cli.js";
import { publicError } from "./client.js";

runCli().catch(error => {
  process.stderr.write(JSON.stringify(publicError(error)) + "\n");
  process.exitCode = 1;
});
