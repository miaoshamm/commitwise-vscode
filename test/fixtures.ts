export const SINGLE_FILE_PATCH = `diff --git a/src/a.ts b/src/a.ts
index 83db48f..bf269f4 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
-const a = 1;
+const a = 2;
 const b = 3;
+const c = 4;
 export { a, b };
`;

export const MULTI_FILE_PATCH = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
diff --git a/package-lock.json b/package-lock.json
index aaaa..bbbb 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,2 +1,3 @@
 {
+  "lockfileVersion": 3,
   "name": "demo"
 }
diff --git a/assets/logo.png b/assets/logo.png
index cccc..dddd 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
`;

export const RENAME_PATCH = `diff --git a/src/old.ts b/src/utils/renamed.ts
similarity index 92%
rename from src/old.ts
rename to src/utils/renamed.ts
index 111..222 100644
--- a/src/old.ts
+++ b/src/utils/renamed.ts
@@ -1,2 +1,2 @@
-export const v = 1;
+export const v = 2;
 export const w = 3;
`;

export const SECRET_PATCH = `diff --git a/src/config.ts b/src/config.ts
index 1..2 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,2 +1,4 @@
+const apiKey = "sk-live-abcdefghijklmnopqrstuvwx";
+const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
 export const host = "api.example.com";
`;

/** 模拟"文件很多且很大"的补丁，用于预算裁剪测试 */
export function bigPatch(fileCount: number, linesPerFile: number): string {
  const parts: string[] = [];
  for (let i = 0; i < fileCount; i++) {
    const lines = Array.from({ length: linesPerFile }, (_, n) => `+const value${i}_${n} = ${n};`).join('\n');
    parts.push(`diff --git a/src/file${i}.ts b/src/file${i}.ts
index aa..bb 100644
--- a/src/file${i}.ts
+++ b/src/file${i}.ts
@@ -0,0 +1,${linesPerFile} @@
${lines}`);
  }
  return parts.join('\n');
}
