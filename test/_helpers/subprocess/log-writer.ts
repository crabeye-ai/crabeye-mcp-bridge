import { LogFile } from "../../../src/logging/log-file.js";

const [path, tag, count, maxBytes] = process.argv.slice(2);
const file = new LogFile({ path, maxBytes: Number(maxBytes) });
const filler = tag.repeat(100);
for (let i = 0; i < Number(count); i++) file.write(`${tag} ${i} ${filler}\n`);
file.close();
