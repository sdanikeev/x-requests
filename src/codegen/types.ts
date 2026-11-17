import type { Method } from '../types.js';

export type FromOpenApi<Paths> = {
  [Path in keyof Paths & string]: MethodsOf<Paths[Path]>;
};

type Defined<T> = Exclude<T, undefined>;

type Simplify<T> = { [K in keyof T]: T[K] };

type MethodsOf<PathItem> = {
  [M in Method as [OperationOf<PathItem, M>] extends [never] ? never : M]: RouteOf<OperationOf<PathItem, M>>;
};

type OperationOf<PathItem, M extends Method> = M extends keyof PathItem
  ? Defined<PathItem[M]>
  : never;

type RouteOf<Operation> = Simplify<
  & ParamsPart<Operation, 'query', 'query'>
  & ParamsPart<Operation, 'header', 'headers'>
  & ParamsPart<Operation, 'path', 'path'>
  & BodyOf<Operation>
  & ResponseOf<Operation>
  & ErrorsOf<Operation>
>;

type IsOptional<Obj, Key extends keyof Obj> = Partial<Pick<Obj, Key>> extends Pick<Obj, Key> ? true : false;

// `query?: {...}` stays optional, `query: {...}` (a required parameter) stays required
type ParamsPart<Operation, Kind extends 'query' | 'header' | 'path', Key extends string>
  = Operation extends { parameters: infer P }
    ? Kind extends keyof P
      ? [Defined<P[Kind]>] extends [never]
          ? unknown
          : IsOptional<P, Kind> extends true
            ? { [K in Key]?: Defined<P[Kind]> }
            : { [K in Key]: Defined<P[Kind]> }
      : unknown
    : unknown;

type ContentOf<Content> = 'application/json' extends keyof Content
  ? Content['application/json']
  : Content[keyof Content];

type PayloadOf<ResponseObject> = ResponseObject extends { content?: infer Content }
  ? [Defined<Content>] extends [never]
      ? undefined
      : ContentOf<Defined<Content>>
  : undefined;

type BodyOf<Operation> = 'requestBody' extends keyof Operation
  ? [Defined<Operation['requestBody']>] extends [never]
      ? unknown
      : Defined<Operation['requestBody']> extends { content: infer Content }
        ? IsOptional<Operation, 'requestBody'> extends true
          ? { body?: ContentOf<Content> }
          : { body: ContentOf<Content> }
        : unknown
  : unknown;

type ResponsesOf<Operation> = Operation extends { responses: infer R } ? R : never;

type StatusKey<Status> = `${Status & (string | number)}`;

type SuccessStatuses<R> = {
  [S in keyof R]: StatusKey<S> extends `2${string}` ? S : never;
}[keyof R];

type ResponseOf<Operation> = [SuccessStatuses<ResponsesOf<Operation>>] extends [never]
  ? unknown
  : { response: PayloadOf<ResponsesOf<Operation>[SuccessStatuses<ResponsesOf<Operation>>]> };

type ErrorStatuses<R> = {
  [S in keyof R]: StatusKey<S> extends `4${string}` | `5${string}` ? S : never;
}[keyof R];

// `default` is "any other status", the same meaning as `errors.default` in routes
type DefaultError<R> = 'default' extends keyof R ? { default: PayloadOf<R['default']> } : unknown;

type ErrorMap<R> = Simplify<
  & { [S in ErrorStatuses<R>]: PayloadOf<R[S]> }
  & DefaultError<R>
>;

type ErrorsOf<Operation> = [keyof ErrorMap<ResponsesOf<Operation>>] extends [never]
  ? unknown
  : { errors: ErrorMap<ResponsesOf<Operation>> };
