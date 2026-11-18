#!/usr/bin/env bun
import { main } from "./main.ts";
import { terminalPrompter } from "./prompt.ts";

const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
const prompt = process.stdin.isTTY ? terminalPrompter() : undefined;
const { code, out } = await main(process.argv.slice(2), process.env, { color, prompt });
(code === 0 ? process.stdout : process.stderr).write(out);
process.exit(code);
