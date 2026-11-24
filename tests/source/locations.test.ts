import { describe, it } from "vitest";
import { addressCase, bindingCase, budgetCase, casCase, checkpointsCase, classificationCase, clockCase, detailCase, multipleCase, ownedCase, partialCase, rollbackCase, schemasCase } from "./location-cases.ts";

describe("Source location resolution", () => {
  it("binds current ad details", detailCase);
  it("reads address evidence", addressCase);
  it("paces address requests", clockCase);
  it("checks source bindings", bindingCase);
  it("checks the source version before writing", casCase);
  it("rolls back a failed write", rollbackCase);
  it("uses its own write transaction", ownedCase);
  it("classifies missing location evidence", classificationCase);
  it("continues from the saved checkpoint", checkpointsCase);
  it("respects the lookup budget", budgetCase);
  it("records partial location evidence", partialCase);
  it("records multiple locations", multipleCase);
  it("rejects invalid resolution inputs", schemasCase);
});
