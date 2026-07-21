export default function AdminPlaceholder({ title }: { title: string }) {
	return (
		<div>
			<h1 className="text-2xl font-semibold text-white">{title}</h1>
			<p className="text-sm text-zinc-400 mt-2">Coming in a later sprint.</p>
		</div>
	)
}
