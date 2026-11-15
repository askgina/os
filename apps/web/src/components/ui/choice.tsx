/** One radio button of a group, with its label and an optional line that explains it. */
export function Choice({
  name,
  label,
  detail,
  checked,
  onChange,
}: {
  name: string;
  label: string;
  detail?: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex min-w-0 items-start gap-2 text-sm">
      <input
        type="radio"
        name={name}
        className="mt-0.5 size-4 shrink-0 accent-(--accent)"
        checked={checked}
        onChange={onChange}
      />
      <span className="min-w-0">
        {label}
        {detail ? <span className="block text-xs text-muted-foreground">{detail}</span> : null}
      </span>
    </label>
  );
}
