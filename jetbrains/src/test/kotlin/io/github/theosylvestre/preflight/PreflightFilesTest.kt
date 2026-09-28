package io.github.theosylvestre.preflight

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PreflightFilesTest {
    @Test
    fun `state files are recognised by name`() {
        assertTrue(PreflightFiles.isStateName("terraform.tfstate"))
        assertTrue(PreflightFiles.isStateName("terraform.tfstate.backup"))
        assertFalse(PreflightFiles.isStateName("tfstate.json"))
    }

    @Test
    fun `plan output of terraform show -json`() {
        assertTrue(PreflightFiles.looksLikeTerraformJson("""{"format_version":"1.2","terraform_version":"1.9.5","planned_values":{}}"""))
    }

    @Test
    fun `state output of terraform show -json and raw state`() {
        assertTrue(PreflightFiles.looksLikeTerraformJson("""{"format_version":"1.0","terraform_version":"1.9.5","values":{}}"""))
        assertTrue(PreflightFiles.looksLikeTerraformJson("{\n  \"version\": 4,\n  \"terraform_version\": \"1.9.5\",\n  \"serial\": 3,\n  \"lineage\": \"x\"\n}"))
    }

    @Test
    fun `other JSON files are left alone`() {
        assertFalse(PreflightFiles.looksLikeTerraformJson("""{"name":"app","version":"1.0.0"}"""))
        assertFalse(PreflightFiles.looksLikeTerraformJson("""{"format_version":"1.0"}"""))
        assertFalse(PreflightFiles.looksLikeTerraformJson("""["terraform_version","format_version"]"""))
        assertFalse(PreflightFiles.looksLikeTerraformJson(""))
    }
}
