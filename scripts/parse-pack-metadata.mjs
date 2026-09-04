function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function parsePackMetadata(output, expected) {
    if (
        typeof expected?.name !== "string" ||
        expected.name.trim().length === 0 ||
        typeof expected.version !== "string" ||
        expected.version.trim().length === 0
    ) {
        throw new Error("expected package identity must contain a name and version")
    }

    let parsed
    try {
        parsed = JSON.parse(output)
    } catch {
        throw new Error("npm pack --dry-run --json did not return valid JSON")
    }

    let result
    if (Array.isArray(parsed)) {
        if (parsed.length !== 1) {
            throw new Error("npm pack must return exactly one package")
        }
        result = parsed[0]
    } else if (isRecord(parsed)) {
        const names = Object.keys(parsed)
        if (names.length !== 1) {
            throw new Error("npm pack must return exactly one package")
        }
        if (names[0] !== expected.name) {
            throw new Error(`npm pack package key must match ${expected.name}`)
        }
        result = parsed[names[0]]
    } else {
        throw new Error("npm pack must return a package array or name-keyed object")
    }

    if (!isRecord(result) || result.name !== expected.name || result.version !== expected.version) {
        throw new Error(`npm pack package identity must match ${expected.name}@${expected.version}`)
    }
    if (
        !Array.isArray(result.files) ||
        result.files.length === 0 ||
        result.files.some(
            (file) =>
                !isRecord(file) || typeof file.path !== "string" || file.path.trim().length === 0,
        )
    ) {
        throw new Error("npm pack must return nonempty file metadata with valid paths")
    }
    return result
}
