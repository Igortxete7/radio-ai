'use client';
import { cva, type VariantProps } from 'class-variance-authority';
import { clsx } from 'clsx';
import type { ButtonHTMLAttributes } from 'react';
const variants = cva('button', {
  variants: {
    variant: {
      default: 'button-primary',
      secondary: 'button-secondary',
      danger: 'button-danger',
      ghost: 'button-ghost',
    },
  },
  defaultVariants: { variant: 'default' },
});
export function Button({
  variant,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof variants>) {
  return <button className={clsx(variants({ variant }), className)} {...props} />;
}
