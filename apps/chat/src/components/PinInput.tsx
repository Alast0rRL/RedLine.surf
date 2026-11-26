import { forwardRef, type ChangeEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { PIN_MAX } from '../lib/pin';
import { Field } from './ui';

type PinInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'inputMode' | 'pattern' | 'autoComplete' | 'autoCorrect' | 'autoCapitalize' | 'spellCheck' | 'maxLength'
> & {
  label: string;
  hint?: string;
  labelHint?: string;
  suffix?: ReactNode;
  error?: string | null;
  /** сколько цифр можно ввести */
  maxLength?: number;
  /** показать цифры вместо точек (при создании PIN) */
  reveal?: boolean;
  /** системный код из SMS: подсказка клавиатуры и автозаполнение */
  oneTimeCode?: boolean;
};

/** Одно поле PIN на все экраны: цифровая клавиатура на любом телефоне, только цифры в значении. */
export const PinInput = forwardRef<HTMLInputElement, PinInputProps>(function PinInput(
  { reveal = false, oneTimeCode = false, maxLength = PIN_MAX, className, onChange, ...rest },
  ref,
) {
  const digitsOnly = (e: ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/\D/g, '').slice(0, maxLength);
    if (value !== e.target.value) e.target.value = value;
    onChange?.(e);
  };
  return (
    <Field
      ref={ref}
      {...rest}
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      autoComplete={oneTimeCode ? 'one-time-code' : 'off'}
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      enterKeyHint="done"
      maxLength={maxLength}
      className={[ 'pin-input', className, reveal && 'pin-input--reveal' ].filter(Boolean).join(' ')}
      onChange={digitsOnly}
    />
  );
});
