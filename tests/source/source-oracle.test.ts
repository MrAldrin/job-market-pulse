import { test } from "vitest";
import { checkOracleCopy } from "./oracle-copy-cases.ts";

test("reads a synthetic Python source database without changing it", checkOracleCopy);
