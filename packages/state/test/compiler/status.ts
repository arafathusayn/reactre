// A response's status, for ./http.ts: whether a response failed, by its destructured `ok`.

export const failed = ({ ok }: Response): boolean => !ok;
