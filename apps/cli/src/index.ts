#!/usr/bin/env bun
import { main } from "./main.ts";

const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
const { code, out } = await main(process.argv.slice(2), process.env, { color });
(code === 0 ? process.stdout : process.stderr).write(out);
process.exit(code);
