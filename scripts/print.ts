#!/usr/bin/env npx tsx

import { Logger } from "../lib/logger"
import { PromptStore } from "../lib/prompts/store"

const showHelp = process.argv.includes("-h") || process.argv.includes("--help")

if (showHelp) {
    console.log(`DCP compaction prompt preview

Usage:
  npm run dcp

Prints the effective semantic-pruning prompt for the current project.`)
    process.exit(0)
}

const store = new PromptStore(new Logger(false), process.cwd(), true)
store.reload()
console.log(store.getRuntimePrompts().compaction)
