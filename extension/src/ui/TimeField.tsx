// One time input for the whole app.
//
// `<input type="time">` is the browser's own: a picker, the keyboard handling,
// the locale's 12- or 24-hour display, and a value that is always "HH:MM" — the
// exact format everything here stores. Typing into a plain text box gave none of
// that and let "9am" or "25:00" through to be dealt with later, in three
// different places, each slightly differently.

export function TimeField({
	value,
	onChange,
	label,
	id,
	disabled,
	width = 120,
	min,
	max,
	/** Minutes between the picker's steps. 60 for an on-the-hour field. */
	step,
}: {
	value: string
	onChange: (hhmm: string) => void
	label: string
	id?: string
	disabled?: boolean
	width?: number
	min?: string
	max?: string
	step?: number
}) {
	return (
		<input
			id={id}
			className="wp-input wp-num"
			style={{ width }}
			type="time"
			value={value}
			disabled={disabled}
			min={min}
			max={max}
			step={step != null ? step * 60 : undefined}
			aria-label={label}
			// Clearing it hands back "", which would store an empty shift. The
			// caller decides what empty means; most want the value left alone.
			onChange={(e) => onChange(e.target.value)}
		/>
	)
}

/**
 * The same for a date and a time together. `datetime-local` gives "YYYY-MM-DDTHH:MM",
 * which is what a reminder is stored as.
 */
export function WhenField({
	value,
	onChange,
	label,
	disabled,
	width = 200,
	min,
}: {
	value: string
	onChange: (when: string) => void
	label: string
	disabled?: boolean
	width?: number
	min?: string
}) {
	return (
		<input
			className="wp-input wp-num"
			style={{ width }}
			type="datetime-local"
			value={value}
			disabled={disabled}
			min={min}
			aria-label={label}
			onChange={(e) => onChange(e.target.value)}
		/>
	)
}

/** A date on its own. "YYYY-MM-DD", which is how every date here is stored. */
export function DateField({
	value,
	onChange,
	label,
	disabled,
	width = 150,
	max,
	min,
}: {
	value: string
	onChange: (date: string) => void
	label: string
	disabled?: boolean
	width?: number
	max?: string
	min?: string
}) {
	return (
		<input
			className="wp-input wp-num"
			style={{ width }}
			type="date"
			value={value}
			disabled={disabled}
			max={max}
			min={min}
			aria-label={label}
			onChange={(e) => onChange(e.target.value)}
		/>
	)
}
