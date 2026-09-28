/** @jsxImportSource react */
import { Button } from '@astryxdesign/core/Button';
import { Link } from '@astryxdesign/core/Link';
import { TextInput } from '@astryxdesign/core/TextInput';

export function SearchForm({
  action,
  label,
  value,
  onChange,
  showClear,
}: {
  action: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  showClear: boolean;
}) {
  return (
    <form method="get" action={action} className="void-admin-search">
      <TextInput
        label={label}
        isLabelHidden
        htmlName="search"
        placeholder={label}
        value={value}
        onChange={onChange}
        width={320}
      />
      <Button type="submit" label="Search" />
      {showClear && <Link href={action}>Clear</Link>}
    </form>
  );
}
