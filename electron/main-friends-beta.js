// Dedicated package entry: never touches the normal AporiaX profile or updates.
import { app } from "electron";
import { join } from "node:path";
app.setName("AporiaX Beta");
if (!process.argv.some(arg => arg.startsWith("--user-data-dir=")))
  app.setPath("userData", join(app.getPath("appData"), "AporiaX Beta"));
process.env.APORIAX_FRIENDS_BETA = "1";
await import("./main-v2.js");
