<script>
import ThemeToggle from "../_ThemeToggle.vue" with { island: "load" }

document.getElementById("mixed-target").textContent = "hydrated"
</script>

---

title: Mixed Test
description: Tests island imports coexisting with client script

---

# Mixed Test

<ThemeToggle />

<span id="mixed-target">pending</span>
