/** @jsxImportSource react */
import {
  createStaticSource,
  Typeahead,
  TypeaheadItem,
  type SearchableItem,
} from '@astryxdesign/core/Typeahead';
import { useMemo, useState } from 'react';

export type SearchSuggestion = Readonly<{
  id: string;
  label: string;
  keywords?: ReadonlyArray<string | null | undefined>;
  description?: string;
}>;

type SearchItem = SearchableItem<{
  keywords: ReadonlyArray<string>;
  description?: string;
}>;

export function SearchTypeahead({
  label,
  onChange,
  suggestions,
  initialValue = '',
  width = 320,
}: {
  label: string;
  onChange: (value: string) => void;
  suggestions: ReadonlyArray<string | SearchSuggestion | null | undefined>;
  initialValue?: string;
  width?: number;
}) {
  const items = useMemo(() => {
    const byId = new Map<string, SearchItem>();
    for (const suggestion of suggestions) {
      if (!suggestion) {
        continue;
      }
      const item: SearchItem =
        typeof suggestion === 'string'
          ? { id: suggestion, label: suggestion, auxiliaryData: { keywords: [] } }
          : {
              id: suggestion.id,
              label: suggestion.label,
              auxiliaryData: {
                keywords:
                  suggestion.keywords?.filter((value): value is string => Boolean(value)) ?? [],
                description: suggestion.description,
              },
            };
      if (item.id && item.label) {
        byId.set(item.id, item);
      }
    }
    return [...byId.values()];
  }, [suggestions]);
  const source = useMemo(
    () =>
      createStaticSource(items, {
        keywords: (item: SearchItem) => item.auxiliaryData?.keywords ?? [],
      }),
    [items],
  );
  const [selected, setSelected] = useState<SearchItem | null>(() =>
    initialValue
      ? (items.find((item) => item.id === initialValue) ?? {
          id: initialValue,
          label: initialValue,
        })
      : null,
  );

  return (
    <Typeahead
      label={label}
      isLabelHidden
      placeholder={label}
      searchSource={source}
      value={selected}
      renderItem={(item: SearchItem) => (
        <TypeaheadItem item={item} description={item.auxiliaryData?.description} />
      )}
      onChange={(item: SearchItem | null) => {
        setSelected(item);
        onChange(item?.id ?? '');
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
