// กันข้อความฝังในหน้าจอ (รันก่อน build ทุกครั้ง):
// 1) ห้ามมีตัวอักษรไทย/ญี่ปุ่น/จีน/เกาหลีในไฟล์ .ts/.tsx นอก locales/ — ข้อความต้องอยู่ในไฟล์ภาษาเท่านั้น
//    (ยกเว้นบรรทัดคอมเมนต์ที่ขึ้นต้นด้วย // หรือ * ซึ่งเป็นคำอธิบายสำหรับนักพัฒนา)
// 2) ทุกไฟล์ภาษาต้องมี key ชุดเดียวกับ en.json
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SCAN = ["app", "components", "lib"];
const NATIVE = /[฀-๿぀-ヿ㐀-鿿가-힯]/;
const problems = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(ts|tsx)$/.test(name)) {
      readFileSync(path, "utf8").split("\n").forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*") || code.startsWith("{/*")) return;
        if (NATIVE.test(line.replace(/\/\/.*$/, "").replace(/\{\/\*.*?\*\/\}/g, ""))) {
          problems.push(`${relative(ROOT, path)}:${i + 1}  text must come from locales/*.json → ${code.slice(0, 80)}`);
        }
      });
    }
  }
}

for (const dir of SCAN) walk(join(ROOT, dir));

const locales = join(ROOT, "locales");
const base = Object.keys(JSON.parse(readFileSync(join(locales, "en.json"), "utf8")));
for (const file of readdirSync(locales).filter((f) => f.endsWith(".json") && f !== "en.json")) {
  const keys = new Set(Object.keys(JSON.parse(readFileSync(join(locales, file), "utf8"))));
  const missing = base.filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !base.includes(k));
  if (missing.length) problems.push(`locales/${file}: missing keys → ${missing.join(", ")}`);
  if (extra.length) problems.push(`locales/${file}: keys not in en.json → ${extra.join(", ")}`);
}

if (problems.length) {
  console.error("i18n check failed:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log(`i18n check passed (${base.length} keys × ${readdirSync(locales).filter((f) => f.endsWith(".json")).length} languages)`);
