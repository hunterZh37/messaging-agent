export interface Leak {
  kind: "address" | "number";
  value: string;
}
export declare const FIXTURE_DOMAINS: Set<string>;
export declare const KNOWN_FIXTURES: Set<string>;
export declare function leaksIn(text: string): Leak[];
export declare function explain(leaks: Leak[], where: string): string;
