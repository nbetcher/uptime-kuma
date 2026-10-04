import { execFileSync } from "node:child_process";

const releaseVersion = process.env.RELEASE_VERSION;
const upstreamVersion = process.env.UPSTREAM_VERSION;
const sourceSha = process.env.SOURCE_SHA;
const previousTag = process.env.PREVIOUS_TAG || "";
const apiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
const githubToken = process.env.GH_TOKEN || "";

for (const [name, value] of Object.entries({ releaseVersion, upstreamVersion, sourceSha, apiKey })) {
    if (!value) {
        throw new Error(`${name} is required`);
    }
}

/**
 * Run git and return trimmed stdout.
 * @param {string[]} args Git arguments
 * @returns {string} Standard output
 */
function git(args) {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }).trim();
}

/**
 * Limit prompt sections while preserving the most recent information.
 * @param {string} value Input text
 * @param {number} maxLength Maximum characters
 * @returns {string} Bounded text
 */
function bounded(value, maxLength) {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, maxLength)}\n[additional details omitted from prompt]`;
}

/**
 * Fetch upstream release notes when available.
 * @returns {Promise<string>} Upstream notes or a fallback
 */
async function upstreamNotes() {
    for (const tag of [`v${upstreamVersion}`, upstreamVersion]) {
        const response = await fetch(
            `https://api.github.com/repos/louislam/uptime-kuma/releases/tags/${encodeURIComponent(tag)}`,
            {
                headers: {
                    Accept: "application/vnd.github+json",
                    "User-Agent": "nbetcher-uptime-kuma-release",
                    ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
                },
                signal: AbortSignal.timeout(15000),
            }
        );
        if (response.ok) {
            const release = await response.json();
            return release.body || `Upstream release ${tag}`;
        }
        if (response.status !== 404) {
            console.error(`Upstream release lookup returned HTTP ${response.status} for ${tag}`);
        }
    }
    return `No upstream release notes were available for ${upstreamVersion}.`;
}

const range = previousTag ? `${previousTag}..${sourceSha}` : sourceSha;
const logArgs = ["log", "--first-parent", "--format=%h%x09%s%x09%b", "--no-decorate"];
if (previousTag) {
    logArgs.push(range);
} else {
    logArgs.push("-n", "75", sourceSha);
}

const commits = git(logArgs) || "No commit summaries available.";
const diffStat = previousTag
    ? git(["diff", "--stat", previousTag, sourceSha])
    : "This is the first rtsp-monitor release tag; no earlier fork release is available for comparison.";
const upstream = await upstreamNotes();

const prompt = `You are writing the public changelog for ${releaseVersion}, a downstream Uptime Kuma release based on upstream ${upstreamVersion}.

Write detailed but approachable GitHub release notes in Markdown. The audience operates Uptime Kuma but does not need implementation-level detail.

Rules:
- Start with a concise overview of what users gain from this release.
- Organize relevant material under clear headings such as Highlights, Improvements, Fixes, Security, and Operations or Compatibility. Omit empty headings.
- Be specific about observable behavior, supported protocols, configuration changes, migrations, compatibility requirements, and meaningful security improvements.
- Water down low-level technical detail. Explain outcomes and operator impact instead of internal classes, functions, packet structures, or library plumbing.
- Consolidate related commits into coherent entries instead of repeating commit messages.
- If a defect was found and fixed while developing an enhancement that is introduced for the first time in this same release, do not present that defect as a user-facing bug. Describe the finished enhancement and its safeguards as one clean feature.
- Do not claim a fix, feature, or test result that is not supported by the supplied material.
- Do not include raw commit hashes in the prose unless they are essential.
- Mention that this is based on upstream ${upstreamVersion} and summarize important upstream changes without copying upstream notes verbatim.
- End with a short Upgrade notes section when the supplied material indicates action or compatibility concerns.
- Output only the Markdown release notes, with no preamble or code fence.

Previous downstream tag: ${previousTag || "none (first downstream release)"}
Current source revision: ${sourceSha}

First-parent downstream commit history:
${bounded(commits, 50000)}

Change summary:
${bounded(diffStat, 20000)}

Upstream release notes:
${bounded(upstream, 40000)}
`;

let lastError;
for (let attempt = 1; attempt <= 4; attempt++) {
    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-goog-api-key": apiKey,
                },
                body: JSON.stringify({
                    contents: [{ role: "user", parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.2,
                        maxOutputTokens: 8192,
                    },
                }),
                signal: AbortSignal.timeout(180000),
            }
        );
        if (!response.ok) {
            throw new Error(`Gemini returned HTTP ${response.status}: ${await response.text()}`);
        }
        const result = await response.json();
        const text = (result.candidates?.[0]?.content?.parts || [])
            .map((part) => part.text || "")
            .join("")
            .trim();
        if (!text) {
            throw new Error("Gemini returned no release notes");
        }
        process.stdout.write(`${text}\n`);
        process.exit(0);
    } catch (error) {
        lastError = error;
        console.error(`Gemini changelog attempt ${attempt}/4 failed: ${error.message}`);
        if (attempt < 4) {
            await new Promise((resolve) => setTimeout(resolve, attempt * attempt * 5000));
        }
    }
}

throw lastError;
