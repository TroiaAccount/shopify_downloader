import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import "dotenv/config";

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const OUTPUT_DIR = process.env.OUTPUT_DIR || "./shopify_files";

if (!SHOPIFY_STORE || !ACCESS_TOKEN) {
    console.error("❌ Missing SHOPIFY_STORE or ACCESS_TOKEN in .env");
    process.exit(1);
}

// создаём подпапки
const subdirs = ["generic", "images", "videos", "models", "external", "unknown"];
for (const dir of subdirs) {
    const full = path.join(OUTPUT_DIR, dir);
    if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
}

// === Получаем список файлов через GraphQL ===
async function fetchAllFiles() {
    let allFiles = [];
    let hasNextPage = true;
    let cursor = null;
    let page = 1;

    while (hasNextPage) {
        console.log(`→ Fetching page ${page}...`);

        const query = `
      query fetchFiles($cursor: String) {
        files(first: 100, after: $cursor) {
          edges {
            cursor
            node {
              __typename
              createdAt
              ... on MediaImage {
                id
                alt
                image { url }
              }
              ... on Video {
                id
                originalSource { url }
              }
              ... on GenericFile {
                id
                url
                alt
                fileStatus
              }
              ... on ExternalVideo {
                id
                embeddedUrl
              }
              ... on Model3d {
                id
                originalSource { url }
              }
            }
          }
          pageInfo { hasNextPage }
        }
      }
    `;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        const res = await fetch(
            `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2024-10/graphql.json`,
            {
                method: "POST",
                headers: {
                    "X-Shopify-Access-Token": ACCESS_TOKEN,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ query, variables: { cursor } }),
                signal: controller.signal,
            }
        ).catch((err) => {
            throw new Error(`Network error: ${err.message}`);
        });

        clearTimeout(timeout);

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`GraphQL error ${res.status}: ${text}`);
        }

        const data = await res.json();
        if (data.errors) {
            console.error("GraphQL Errors:", data.errors);
            throw new Error("Shopify GraphQL query failed");
        }

        const edges = data.data.files.edges || [];
        allFiles.push(...edges.map((e) => e.node));

        hasNextPage = data.data.files.pageInfo.hasNextPage;
        cursor = hasNextPage ? edges[edges.length - 1].cursor : null;
        page++;
    }

    return allFiles;
}

// === Определяем тип и URL ===
function resolveFileInfo(file) {
    let url = null;
    let folder = "unknown";

    switch (file.__typename) {
        case "GenericFile":
            url = file.url;
            folder = "generic";
            break;
        case "MediaImage":
            url = file.image?.url;
            folder = "images";
            break;
        case "Video":
            url = file.originalSource?.url;
            folder = "videos";
            break;
        case "ExternalVideo":
            url = file.embeddedUrl;
            folder = "external";
            break;
        case "Model3d":
            url = file.originalSource?.url;
            folder = "models";
            break;
    }

    return { url, folder };
}

// === Скачиваем с прогрессом ===
async function downloadFiles(files) {
    let downloaded = 0;
    const total = files.length;

    for (const file of files) {
        const { url, folder } = resolveFileInfo(file);
        if (!url) {
            console.warn(`⚠️ Skipped: no URL for ${file.id} (${file.__typename})`);
            continue;
        }

        const cleanUrl = url.split("?")[0];
        const fileName = path.basename(cleanUrl);
        const filePath = path.join(OUTPUT_DIR, folder, fileName);

        if (fs.existsSync(filePath)) {
            downloaded++;
            const percent = ((downloaded / total) * 100).toFixed(1);
            process.stdout.write(`⏩ ${percent}% (${downloaded}/${total}) Skipped ${folder}/${fileName}\r`);
            continue;
        }

        try {
            const res = await fetch(url);
            if (!res.ok) {
                console.error(`❌ Failed to download ${fileName}: ${res.statusText}`);
                continue;
            }

            const buffer = await res.arrayBuffer();
            fs.writeFileSync(filePath, Buffer.from(buffer));

            downloaded++;
            const percent = ((downloaded / total) * 100).toFixed(1);
            process.stdout.write(`✅ ${percent}% (${downloaded}/${total}) Saved ${folder}/${fileName}\r`);
        } catch (e) {
            console.error(`❌ Error downloading ${url}: ${e.message}`);
        }
    }

    console.log(`\n🎉 All files processed (${downloaded}/${total}).`);
}

// === Запуск ===
(async () => {
    try {
        console.log("📦 Fetching all files via GraphQL...");
        const files = await fetchAllFiles();
        console.log(`✅ Found ${files.length} total files`);

        await downloadFiles(files);
        console.log("🎉 Done! All available files saved in:", OUTPUT_DIR);
    } catch (err) {
        console.error("❌ Error:", err.message);
    }
})();
