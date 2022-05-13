#!/usr/bin/env node

import { program } from "commander";
import { analyse } from "./analyse.js";

program
  .name("elmjs-inspector")
  .description("Analyse your elm.js file size with this tool.")
  .version("1.0.0");

program
  .command("analyze")
  .argument("<filename>", "The file to analyze")
  .option("-t --terser", "Run terser on the file before calculating the scores")
  .action((filename, options) => {
    analyse(filename, options);
  });

program.parse();
