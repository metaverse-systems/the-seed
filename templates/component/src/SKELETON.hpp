#pragma once

#include <libecs-cpp/ecs.hpp>

class SKELETON : public ecs::Component
{
  public:
    SKELETON(); 
    SKELETON(nlohmann::json);
    nlohmann::json Export();
};
