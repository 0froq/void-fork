/** @jsxImportSource react */
import { Button } from '@astryxdesign/core/Button';
import { Link } from '@astryxdesign/core/Link';
import { SearchTypeahead, type SearchSuggestion } from './SearchTypeahead.tsx';

export function SearchForm({
  action,
  label,
  value,
  onChange,
  suggestions,
  initialValue,
  showClear,
}: {
  action: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  suggestions: ReadonlyArray<string | SearchSuggestion | null | undefined>;
  initialValue?: string;
  showClear: boolean;
}) {
  return (
    <form method="get" action={action} className="void-admin-search">
      <input type="hidden" name="search" value={value} />
      <SearchTypeahead
        key={initialValue ?? ''}
        label={label}
        onChange={onChange}
        suggestions={suggestions}
        initialValue={initialValue}
      />
      <Button type="submit" label="Search" />
      {showClear && <Link href={action}>Clear</Link>}
    </form>
  );
}
