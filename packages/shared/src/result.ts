export interface Ok<TValue> {
  readonly ok: true;
  readonly value: TValue;
}

export interface Err<TError> {
  readonly ok: false;
  readonly error: TError;
}

export type Result<TValue, TError> = Ok<TValue> | Err<TError>;

export const ok = <TValue>(value: TValue): Ok<TValue> => ({ ok: true, value });

export const err = <TError>(error: TError): Err<TError> => ({ ok: false, error });
