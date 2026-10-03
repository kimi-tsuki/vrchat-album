import { Description, Input, Label, TextArea, TextField } from '@heroui/react';

interface FieldProps {
  label: string;
  value: string;
  onChange(value: string): void;
  description?: string;
  placeholder?: string;
  multiline?: boolean;
  isDisabled?: boolean;
  maxLength?: number;
}
export function Field({ label, description, multiline, placeholder, maxLength, ...props }: FieldProps) {
  return <TextField {...props} className="album-field">
    <Label>{label}</Label>
    {multiline ? <TextArea placeholder={placeholder} maxLength={maxLength} rows={4} /> : <Input placeholder={placeholder} maxLength={maxLength} />}
    {description && <Description>{description}</Description>}
  </TextField>;
}
