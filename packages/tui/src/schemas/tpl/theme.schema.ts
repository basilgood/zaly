// oxlint-disable import/no-named-as-default-member
// @ts-ignore -- type used only in the typia generic; inlined away by codegen
import type { Theme } from "../../themes/types.ts"

import typia from "typia"

export const ThemeSchema = typia.json.schema<[Theme], "3.0">()
