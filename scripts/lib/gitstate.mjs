// Classify `git status --porcelain` output into publishable data changes and everything else.
// The raw output must not be trimmed: the first status column of the first line can be a space.
export function classifyStatus(raw, dataPaths) {
  const rows = raw.split('\n').filter(Boolean).map(line => {
    let file = line.slice(3);
    if (file.includes(' -> ')) file = file.split(' -> ').at(-1); // renames report "old -> new"
    return { code: line.slice(0, 2), file: file.replace(/^"|"$/g, '') };
  });
  const isData = file => dataPaths.some(p => file === p || file.startsWith(p.endsWith('/') ? p : p + '/'));
  return {
    data_changes: rows.filter(r => isData(r.file)).length,
    // Untracked files outside the data paths are left alone; they are never staged by the publisher.
    other_changes: rows.filter(r => r.code !== '??' && !isData(r.file)).map(r => r.file),
    staged_other: rows.filter(r => r.code !== '??' && r.code[0] !== ' ' && !isData(r.file)).map(r => r.file),
  };
}
