// oxlint-disable import/no-named-as-default-member
// @ts-ignore -- type used only in the typia generic; inlined away by codegen
import type { ModelsJson } from "@zaly/ai"

import typia from "typia"

export const ModelsSchema = typia.json.schema<[ModelsJson], "3.0">()
