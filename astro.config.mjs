// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import react from "@astrojs/react";

// https://astro.build/config
export default defineConfig({
  site: "https://chunkhound.github.io",
  base: "/",
  redirects: {
    "/code-expert-agent": "/code-research",
  },
  integrations: [
    react(),
    starlight({
      title: "ChunkHound",
      description:
        "Modern RAG for your codebase - semantic and regex search via MCP",
      logo: {
        light: "./public/wordmark.svg",
        dark: "./public/wordmark-dark.svg",
        replacesTitle: true,
      },
      favicon: "/favicon.svg",
      customCss: ["./src/styles/colors.css", "./src/styles/changelog.css"],
      expressiveCode: {
        themes: ["github-light", "github-dark"],
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/chunkhound/chunkhound",
        },
      ],
      head: [
        // Open Graph
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: "https://chunkhound.github.io/og-image.png",
          },
        },
        {
          tag: "meta",
          attrs: {
            property: "og:image:width",
            content: "1200",
          },
        },
        {
          tag: "meta",
          attrs: {
            property: "og:image:height",
            content: "630",
          },
        },
        {
          tag: "meta",
          attrs: {
            property: "og:type",
            content: "website",
          },
        },
        // Twitter Card
        {
          tag: "meta",
          attrs: {
            name: "twitter:card",
            content: "summary_large_image",
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "twitter:image",
            content: "https://chunkhound.github.io/og-image.png",
          },
        },
      ],
      sidebar: [
        { label: "Quickstart", slug: "quickstart" },
        { label: "How-To Guides", slug: "how-to" },
        { label: "Configuration", slug: "configuration" },
        { label: "Code Research", slug: "code-research" },
        { label: "Benchmark", slug: "benchmark" },
        { label: "Under the Hood", slug: "under-the-hood" },
        { label: "Origin Story", slug: "origin-story" },
        { label: "Contributing", slug: "contributing" },
        { label: "Changelog", link: "/changelog" },
      ],
    }),
  ],
});
