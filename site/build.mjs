import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("out", { recursive: true });
copyFileSync("site/index.html", "out/index.html");
