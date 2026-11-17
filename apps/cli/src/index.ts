#!/usr/bin/env bun
import { main } from "./main.ts";

const { code, out } = await main(process.argv.slice(2));
(code === 0 ? process.stdout : process.stderr).write(out);
process.exit(code);
