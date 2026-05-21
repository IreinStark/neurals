import "./axiosConfig";
import { BrowserRouter as Router, Switch, Route } from "react-router-dom";
import DefaultNavbar from "../src/components/Navbar";
import Login from "./screens/LoginForm";
import SignupForm from "./screens/SignupForm";
import StyleTransferCarousel from "./screens/StyleTransfer";
import HomeCaraousel from "./screens/Home";
import WebcamStudio from "./screens/WebcamStudio";
import VideoUpload from "./screens/VideoUpload";
import ForgotPassword from "./screens/ForgotPassword";
import ResetPassword from "./screens/ResetPassword";
import { ThemeProvider } from "./context/ThemeContext";
import "./styles/neu.css";

const App = () => {
  return (
    <ThemeProvider>
      <div className="App">
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/bootstrap@4.6.0/dist/css/bootstrap.min.css"
          integrity="sha384-B0vP5xmATw1+K9KRQjQERJvTumQW0nPEzvF6L/Z6nronJ3oUOFUFpCjEUQouq2+l"
          crossOrigin="anonymous"
        />

        <Router>
          <DefaultNavbar />
          <Switch>
            <Route path="/login" component={Login} exact />
            <Route path="/signup" component={SignupForm} exact />
            <Route
              path="/style_transfer"
              component={StyleTransferCarousel}
              exact
            />
            <Route path="/webcam" component={WebcamStudio} exact />
            <Route path="/video-upload" component={VideoUpload} exact />
            <Route path="/forgot-password" component={ForgotPassword} exact />
            <Route path="/reset-password" component={ResetPassword} exact />
            <Route path="/" component={HomeCaraousel} exact />
          </Switch>
        </Router>
      </div>
    </ThemeProvider>
  );
};

export default App;
