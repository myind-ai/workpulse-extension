// Where a lesson came from, as a small chip, and the button row that narrows a list to one source.
// Checked before writing: the `.wp-chip` classes and the kind/scope button rows in BrainView; no component
// drew a source, so this is the only new one, shared by the Brain, ticket and Learnings pages.

import { SOURCE_LABEL, SOURCE_TYPES, sourceLink, type BridgeEntry, type SourceType } from '@/core/bridge'

export type SourceChoice = SourceType | 'none' | 'all'

/** The type as a chip; a link only when the source carries a safe http(s) URL. Nothing without a source. */
export function SourceChip({ source }: { source?: BridgeEntry['source'] }) {
	if (!source) return null
	const href = sourceLink(source)
	const label = SOURCE_LABEL[source.type] ?? source.type
	const tip = [source.title, source.by && `by ${source.by}`].filter(Boolean).join(' · ') || label
	return href ? (
		<a className="wp-chip wp-chip-source" href={href} target="_blank" rel="noreferrer" title={tip}>
			{label} ↗
		</a>
	) : (
		<span className="wp-chip wp-chip-source" title={tip}>
			{label}
		</span>
	)
}

/** One button per source that has entries, plus Everything; the chosen one is pressed. */
export function SourceFilter({ value, counts, onChange }: { value: SourceChoice; counts: Partial<Record<SourceType | 'none', number>>; onChange: (v: SourceChoice) => void }) {
	const kinds = ([...SOURCE_TYPES, 'none'] as const).filter((k) => (counts[k] ?? 0) > 0 || value === k)
	return (
		<span className="wp-row" role="group" aria-label="Source">
			{(['all', ...kinds] as const).map((k) => (
				<button key={k} className={value === k ? 'wp-btn wp-btn-sm wp-btn-soft' : 'wp-btn wp-btn-sm'} aria-pressed={value === k} onClick={() => onChange(k)}>
					{k === 'all' ? 'Any source' : SOURCE_LABEL[k]}
					{k !== 'all' && <span className="wp-muted"> {counts[k] ?? 0}</span>}
				</button>
			))}
		</span>
	)
}
