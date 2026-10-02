/** @jsxImportSource react */
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { Selector } from '@astryxdesign/core/Selector';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useEffect, useState } from 'react';

export function FormTextInput({
  label,
  name,
  initialValue = '',
  type = 'text',
  required = false,
  maxLength,
  placeholder,
  description,
  isReadOnly,
  autoComplete,
  width,
}: {
  label: string;
  name: string;
  initialValue?: string;
  type?: 'text' | 'password' | 'email' | 'url';
  required?: boolean;
  maxLength?: number;
  placeholder?: string;
  description?: string;
  isReadOnly?: boolean;
  autoComplete?: string;
  width?: number;
}) {
  const [value, setValue] = useState(initialValue);
  useEffect(() => setValue(initialValue), [initialValue]);
  return (
    <TextInput
      label={label}
      htmlName={name}
      value={value}
      onChange={setValue}
      // Astryx forwards the type to the native input but its type union omits url.
      type={type as 'text' | 'password' | 'email'}
      isRequired={required}
      required={required}
      maxLength={maxLength}
      placeholder={placeholder}
      description={description}
      isReadOnly={isReadOnly}
      autoComplete={autoComplete}
      width={width}
    />
  );
}

export function FormTextArea({
  label,
  name,
  initialValue = '',
  required = false,
  placeholder,
  rows = 3,
  width,
}: {
  label: string;
  name: string;
  initialValue?: string;
  required?: boolean;
  placeholder?: string;
  rows?: number;
  width?: number;
}) {
  const [value, setValue] = useState(initialValue);
  useEffect(() => setValue(initialValue), [initialValue]);
  return (
    <TextArea
      label={label}
      htmlName={name}
      value={value}
      onChange={setValue}
      isRequired={required}
      required={required}
      placeholder={placeholder}
      rows={rows}
      width={width}
    />
  );
}

export function FormSelector({
  label,
  name,
  options,
  initialValue,
  width,
  hasSearch = false,
}: {
  label: string;
  name: string;
  options: Array<{ value: string; label: string }>;
  initialValue: string;
  width?: number;
  hasSearch?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  useEffect(() => setValue(initialValue), [initialValue]);
  return (
    <Selector
      label={label}
      htmlName={name}
      options={options}
      value={value}
      onChange={setValue}
      width={width}
      hasSearch={hasSearch}
    />
  );
}

export function FormCheckbox({
  label,
  name,
  submitValue,
  initialValue = false,
}: {
  label: string;
  name: string;
  submitValue: string;
  initialValue?: boolean;
}) {
  const [checked, setChecked] = useState(initialValue);
  useEffect(() => setChecked(initialValue), [initialValue]);
  return (
    <>
      <CheckboxInput label={label} value={checked} onChange={setChecked} />
      {checked && <input type="hidden" name={name} value={submitValue} />}
    </>
  );
}

export function FormNumberInput({
  label,
  name,
  width,
  initialValue = null,
  min = 1,
  max,
  required = false,
}: {
  label: string;
  name: string;
  width?: number;
  initialValue?: number | null;
  min?: number;
  max?: number;
  required?: boolean;
}) {
  const [value, setValue] = useState<number | null>(initialValue);
  useEffect(() => setValue(initialValue), [initialValue]);
  return (
    <NumberInput
      label={label}
      htmlName={name}
      value={value}
      onChange={setValue}
      min={min}
      max={max}
      isRequired={required}
      required={required}
      isIntegerOnly
      hasClear
      width={width}
    />
  );
}
