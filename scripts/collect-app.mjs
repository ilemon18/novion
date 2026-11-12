// Copies the freshly bundled debug artifact into ./release so there is exactly
// one place to look for a build:
//
//   macOS    release/Novion-debug.app          (pnpm app:build)
//   Windows  release/Novion-debug-setup.exe    (pnpm app:build:win)
//
// Both debug scripts end here, so the naming rule lives in one file instead of
// being repeated per platform.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const releaseDir = join(root, "release");
const bundleDir = join(root, "src-tauri", "target", "debug", "bundle");
const onWindows = process.platform === "win32";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const megabytes = (size) => (size / 1024 / 1024).toFixed(1);

mkdirSync(releaseDir, { recursive: true });

if (onWindows) {
  // tauri names the installer `{productName}_{version}_{arch}-setup.exe`, so the
  // exact file depends on the version in tauri.conf.json. Glob it (and insist on
  // a single hit) instead of hardcoding a name that a version bump would break.
  const source = join(bundleDir, "nsis");
  if (!existsSync(source)) {
    fail(`没有找到构建产物：${source}\n请先运行 pnpm app:build:win。`);
  }
  const installers = readdirSync(source).filter((name) => name.toLowerCase().endsWith(".exe"));
  if (installers.length !== 1) {
    fail(`期望 ${source} 里只有一个 .exe，实际找到 ${installers.length} 个。`);
  }

  const target = join(releaseDir, "Novion-debug-setup.exe");
  // replace the previous copy so a stale installer can never be handed out
  rmSync(target, { force: true });
  cpSync(join(source, installers[0]), target);
  console.log(
    `已复制到 release\\Novion-debug-setup.exe（安装包 ${megabytes(statSync(target).size)} MB，来自 ${installers[0]}）`,
  );
  console.log("双击安装即可（按当前用户安装，无需管理员权限）。");
} else {
  const source = join(bundleDir, "macos", "Novion.app");
  if (!existsSync(source)) {
    fail(`没有找到构建产物：${source}\n请先运行 pnpm app:build。`);
  }
  const binary = join(source, "Contents", "MacOS", "novion");
  if (!existsSync(binary)) {
    fail(`构建产物不完整（缺少可执行文件）：${binary}`);
  }

  const target = join(releaseDir, "Novion-debug.app");
  // replace the previous copy so a stale bundle can never be opened by accident
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });

  const size = megabytes(statSync(join(target, "Contents", "MacOS", "novion")).size);
  console.log(`已复制到 release/Novion-debug.app（可执行文件 ${size} MB）`);
  console.log("open release/Novion-debug.app");
}