/** @jsxImportSource react */
import { createStaticSource, Typeahead, type SearchableItem } from '@astryxdesign/core/Typeahead';
import { useMemo, useState } from 'react';

export function SearchTypeahead({
  label,
  onChange,
  suggestions,
  initialValue = '',
  width = 320,
}: {
  label: string;
  onChange: (value: string) => void;
  suggestions: ReadonlyArray<string | null | undefined>;
  initialValue?: string;
  width?: number;
}) {
  const [selected, setSelected] = useState<SearchableItem | null>(
    initialValue ? { id: initialValue, label: initialValue } : null,
  );
  const source = useMemo(() => {
    const labels = [...new Set(suggestions.filter((item): item is string => Boolean(item)))];
    return createStaticSource(labels.map((item) => ({ id: item, label: item })));
  }, [suggestions]);

  return (
    <Typeahead
      label={label}
      isLabelHidden
      placeholder={label}
      searchSource={source}
      value={selected}
      onChange={(item: SearchableItem | null) => {
        setSelected(item);
        onChange(item?.label ?? '');
      }}
      onChangeQuery={(query: string) => {
        setSelected(null);
        onChange(query);
      }}
      hasEntriesOnFocus
      debounceMs={0}
      width={width}
      emptySearchResultsText="No suggestions. Search for any text."
    />
  );
}
