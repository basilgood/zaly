// oxlint-disable import/no-named-as-default-member
// @ts-ignore -- type used only in the typia generic; inlined away by codegen
import type { TypiaConfig } from "../../types.ts"

import typia from "typia"

export const ConfigSchema = typia.json.schema<[TypiaConfig], "3.0">()
