plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
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

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
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
