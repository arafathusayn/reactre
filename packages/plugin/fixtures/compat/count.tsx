// A TSX module of the compat fixture: TypeScript is stripped before it is compiled.

interface Props {
  readonly value: number;
}

export const Count = ({ value }: Props) => <p className="count">Count: {value}</p>;
