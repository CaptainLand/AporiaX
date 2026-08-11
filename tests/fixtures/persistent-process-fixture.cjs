"use strict";

console.log("ready");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  console.log(`echo:${data.trim()}`);
});
process.stdin.resume();
