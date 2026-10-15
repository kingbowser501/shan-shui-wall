import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The release key lives outside the repo (never commit it). Back up the whole folder:
// Android only installs updates signed with the same key as the installed app.
val signing = Properties().apply {
    val f = file(System.getenv("SHANSHUI_SIGNING") ?: "${System.getProperty("user.home")}/.shan-shui-signing/keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "io.github.kingbowser501.shanshui"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.kingbowser501.shanshui"
        minSdk = 26
        targetSdk = 34 // the frame runs Android 14
        versionCode = 1
        versionName = "0.1.0"
    }

    // The painting itself is the web app in ../../public, bundled as-is.
    sourceSets["main"].assets.srcDirs("../../public")

    signingConfigs {
        if (signing.isNotEmpty()) {
            create("release") {
                storeFile = file(signing.getProperty("storeFile"))
                storePassword = signing.getProperty("storePassword")
                keyAlias = signing.getProperty("keyAlias")
                keyPassword = signing.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Without the release key (e.g. on another machine) fall back to the debug key,
            // which builds fine but can't update a frame that has the release-signed app.
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
}
